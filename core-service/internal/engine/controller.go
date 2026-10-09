package engine

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

type Account interface {
	telegram.MediaDownloader
	Run(context.Context, func()) error
	Fingerprint() string
	RefreshMessage(context.Context, *tg.Message) (*telegram.RefreshedMessage, error)
}
type historyRecoverable interface{ SupportsHistoryRecovery() bool }

type jobsAccount interface {
	RunJobs(context.Context, func()) error
	StartObserving(context.Context) error
}

type Dialog struct {
	ID, Name, Username, Type string
	Archived                 bool
	Members                  *int
	AccountIDs               []string
	Access                   telegram.DialogAccess
	AccountAccess            map[string]telegram.DialogAccess
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

// UpdateObserver must persist its effects before returning. Any error prevents
// acknowledgement of the Telegram update, just like durable queue ingestion.
type UpdateObserver func(context.Context, string, tg.UpdateClass) error

var ErrEngineNotRunning = errors.New("Engine is not running. Start the monitor first.")

type Controller struct {
	writer, reader *sql.DB
	work           *WorkStore
	dataDir        string
	factory        Factory
	filter         Filter
	sink           Sink
	observer       UpdateObserver
	notify         func(string, error)
	opMu           sync.Mutex
	mu             sync.Mutex
	state          string
	lastError      error
	started        time.Time
	run            *running
	attemptLimit   func(int64) time.Duration
	bandwidth      bandwidthLimiter
	received       atomic.Int64 // media bytes received by all workers
}

// BytesReceived grows while any download is transferring; history
// backpressure uses it to tell slow large files from a stuck queue.
func (c *Controller) BytesReceived() int64 { return c.received.Load() }

func (c *Controller) SetUpdateObserver(observer UpdateObserver) {
	c.mu.Lock()
	c.observer = observer
	c.mu.Unlock()
}

type running struct {
	promotionCancel context.CancelFunc // guarded by controller.opMu
	observing       atomic.Bool
	jobUsers        atomic.Int64
	dialogPhotos    map[string][]RecoveryDialog // guarded by mu
	ctx             context.Context
	cancel          context.CancelCauseFunc
	done            chan struct{}
	wake            chan struct{}
	accounts        map[string]Account
	ids             []string
	workers         int
	maxAttempts     int
	mu              sync.Mutex
	active          map[int64]context.CancelFunc
	activeOrigin    map[int64]string
	progress        map[int64]*transferStats
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
	manual := c.run != nil && !c.run.observing.Load()
	c.mu.Unlock()
	if c.notify != nil && !manual {
		c.notify(state, cause)
	}
}

func (c *Controller) Dialogs(ctx context.Context, limit int) ([]Dialog, error) {
	session, err := c.OpenDialogs(ctx)
	if err != nil {
		return nil, err
	}
	defer session.Close()
	return session.List(limit)
}

// DialogSession keeps an account run alive while browsing, without enabling
// live downloads. Hard stops still cancel its RPCs, as for manual downloads.
type DialogSession struct {
	run    *running
	ctx    context.Context
	cancel context.CancelFunc
	stop   func() bool
	once   sync.Once
}

func (c *Controller) OpenDialogs(ctx context.Context) (*DialogSession, error) {
	c.opMu.Lock()
	defer c.opMu.Unlock()
	c.mu.Lock()
	defer c.mu.Unlock()
	run := c.run
	if run == nil || c.state != "running" {
		return nil, ErrEngineNotRunning
	}
	if run.ctx != nil {
		if err := run.ctx.Err(); err != nil {
			return nil, err
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	s := &DialogSession{run: run, ctx: ctx, cancel: cancel}
	if run.ctx != nil {
		s.stop = context.AfterFunc(run.ctx, cancel)
	}
	run.jobUsers.Add(1)
	return s, nil
}

func (s *DialogSession) Close() {
	s.once.Do(func() {
		if s.stop != nil {
			s.stop()
		}
		s.cancel()
		s.run.jobUsers.Add(-1)
	})
}

func (s *DialogSession) Err() error {
	if s.run.ctx != nil && s.run.ctx.Err() != nil {
		return s.run.ctx.Err()
	}
	return s.ctx.Err()
}

func (s *DialogSession) List(limit int) ([]Dialog, error) {
	ctx := s.ctx
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if limit != -1 && (limit <= 0 || limit > 1000) {
		limit = 500
	}
	accounts, accountIDs := s.run.accounts, s.run.ids
	if len(accounts) == 0 {
		return nil, errors.New("Telegram monitor is not running")
	}
	merged := map[string]Dialog{}
	order := make([]string, 0)
	accountSets := map[string]map[string]bool{}
	accessSets := map[string]map[string]telegram.DialogAccess{}
	var photoCandidates []RecoveryDialog
	for _, id := range accountIDs {
		account := accounts[id]
		source, ok := account.(dialogSource)
		if !ok {
			return nil, fmt.Errorf("account %s cannot list Telegram dialogs", id)
		}
		for _, archived := range []bool{false, true} {
			items, err := source.Dialogs(ctx, limit, archived)
			if err != nil {
				return nil, fmt.Errorf("list account %s dialogs (archived=%t): %w", id, archived, err)
			}
			for _, item := range items {
				photoCandidates = append(photoCandidates, RecoveryDialog{Dialog: item, AccountID: id})
				if accessSets[item.ID] == nil {
					accessSets[item.ID] = map[string]telegram.DialogAccess{}
				}
				if previous, exists := accessSets[item.ID][id]; !exists || (previous.State == "" || previous.State == "unknown") && item.Access.State != "" {
					accessSets[item.ID][id] = item.Access
				}
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
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	out := make([]Dialog, 0, len(order))
	for _, id := range order {
		item := merged[id]
		for accountID := range accountSets[id] {
			item.AccountIDs = append(item.AccountIDs, accountID)
		}
		sort.Strings(item.AccountIDs)
		item.AccountAccess = accessSets[id]
		for _, accountID := range item.AccountIDs {
			access := item.AccountAccess[accountID]
			if item.Access.State == "" || dialogAccessPriority(access.State) > dialogAccessPriority(item.Access.State) {
				item.Access = access
			}
		}
		out = append(out, item)
	}
	s.rememberDialogPhotos(photoCandidates)
	return out, nil
}

func dialogAccessPriority(state string) int {
	switch state {
	case "ok":
		return 3
	case "", "unknown":
		return 2
	default:
		return 1
	}
}

func (c *Controller) queueRun() (*running, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.run == nil || c.state != "running" {
		return nil, ErrEngineNotRunning
	}
	return c.run, nil
}

func (c *Controller) RequireRunning() error {
	_, err := c.queueRun()
	return err
}

func (c *Controller) wake(run *running) {
	select {
	case run.wake <- struct{}{}:
	default:
	}
}

func (c *Controller) PauseAll(ctx context.Context) error {
	run, err := c.queueRun()
	if err != nil {
		return err
	}
	if err = c.work.SetQueuePaused(ctx, true); err == nil {
		c.wake(run)
	}
	return err
}

func (c *Controller) ResumeAll(ctx context.Context) error {
	run, err := c.queueRun()
	if err != nil {
		return err
	}
	if err = c.work.SetQueuePaused(ctx, false); err == nil {
		c.wake(run)
	}
	return err
}

func (c *Controller) CancelAllQueued(ctx context.Context) (int, error) {
	run, err := c.queueRun()
	if err != nil {
		return 0, err
	}
	removed, err := c.work.CancelAllQueued(ctx)
	if err == nil {
		c.wake(run)
	}
	return removed, err
}

func (c *Controller) PauseJob(ctx context.Context, key string) (bool, error) {
	run, err := c.queueRun()
	if err != nil {
		return false, err
	}
	ok, err := c.work.PauseJob(ctx, key)
	if err == nil {
		c.wake(run)
	}
	return ok, err
}

func (c *Controller) ResumeJob(ctx context.Context, key string) (bool, error) {
	run, err := c.queueRun()
	if err != nil {
		return false, err
	}
	ok, err := c.work.ResumeJob(ctx, key)
	if err == nil {
		c.wake(run)
	}
	return ok, err
}

func (c *Controller) CancelJob(ctx context.Context, key string) (bool, error) {
	run, err := c.queueRun()
	if err != nil {
		return false, err
	}
	ok, err := c.work.CancelJob(ctx, key)
	if err == nil {
		if ok {
			// Cancelling a processing row must stop the in-flight media
			// transport as well as marking the durable row skipped. The worker
			// will observe the cancelled context and leave no partial claim.
			var id int64
			if queryErr := c.reader.QueryRowContext(ctx, `SELECT id FROM tgdl_work WHERE group_id||'_'||message_id=? LIMIT 1`, key).Scan(&id); queryErr == nil {
				run.mu.Lock()
				cancel := run.active[id]
				run.mu.Unlock()
				if cancel != nil {
					cancel()
				}
			}
		}
		c.wake(run)
	}
	return ok, err
}

func (c *Controller) RetryJob(ctx context.Context, key string) (bool, error) {
	run, err := c.queueRun()
	if err != nil {
		return false, err
	}
	ok, err := c.work.RetryJob(ctx, key)
	if err == nil {
		c.wake(run)
	}
	return ok, err
}

func (c *Controller) RetryAll(ctx context.Context) (int, error) {
	run, err := c.queueRun()
	if err != nil {
		return 0, err
	}
	count, err := c.work.RetryAll(ctx)
	if err == nil {
		c.wake(run)
	}
	return count, err
}

func (c *Controller) DismissJob(ctx context.Context, key string) (bool, error) {
	run, err := c.queueRun()
	if err != nil {
		return false, err
	}
	ok, err := c.work.DismissJob(ctx, key)
	if err == nil {
		c.wake(run)
	}
	return ok, err
}

func (c *Controller) ClearFinished(ctx context.Context) error {
	return c.work.ClearFinished(ctx)
}
func (c *Controller) Start(request, parent context.Context, accounts []AccountConfig, workers, maxAttempts int) error {
	return c.start(request, parent, accounts, workers, maxAttempts, true)
}

func (c *Controller) StartJobs(request, parent context.Context, accounts []AccountConfig, workers, maxAttempts int) error {
	return c.start(request, parent, accounts, workers, maxAttempts, false)
}

func (c *Controller) start(request, parent context.Context, accounts []AccountConfig, workers, maxAttempts int, observing bool) error {
	c.opMu.Lock()
	locked := true
	defer func() {
		if locked {
			c.opMu.Unlock()
		}
	}()
	c.mu.Lock()
	old := c.run
	state := c.state
	c.mu.Unlock()
	if old != nil {
		select {
		case <-old.done:
		default:
			if state == "running" && old.ctx.Err() == nil {
				if !observing {
					return nil
				}
				if !old.observing.Swap(true) {
					c.setState("starting", nil)
					promotion, stop := context.WithTimeout(request, 30*time.Minute)
					old.promotionCancel = stop
					// Recovery may take time. Allow Stop to cancel it and keep the
					// existing connection alive for in-flight manual transfers.
					c.opMu.Unlock()
					locked = false
					stopRun := context.AfterFunc(old.ctx, stop)
					var promoteErr error
					for _, id := range old.ids {
						if account, ok := old.accounts[id].(jobsAccount); ok {
							if promoteErr = account.StartObserving(promotion); promoteErr != nil {
								promoteErr = fmt.Errorf("account %s observation: %w", id, promoteErr)
								break
							}
						}
					}
					stopRun()
					stop()
					c.opMu.Lock()
					locked = true
					old.promotionCancel = nil
					if promoteErr != nil {
						// StopObserving can cancel the promotion wait while keeping
						// explicit manual transfers on this authenticated connection.
						if old.ctx.Err() == nil && !old.observing.Load() && errors.Is(promoteErr, context.Canceled) {
							c.setState("running", nil)
							return promoteErr
						}
						old.cancel(promoteErr)
						c.opMu.Unlock()
						locked = false
						<-old.done
						return promoteErr
					}
					if old.ctx.Err() != nil {
						return context.Cause(old.ctx)
					}
					if !old.observing.Load() {
						c.setState("running", nil)
						return context.Canceled
					}
					c.mu.Lock()
					c.started = time.Now()
					c.mu.Unlock()
					c.setState("running", nil)
					c.wake(old)
					return nil
				}
			}
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
	run.observing.Store(observing)
	run.activeOrigin = map[int64]string{}
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
			startAccount := run.accounts[id].Run
			if !observing {
				if account, ok := run.accounts[id].(jobsAccount); ok {
					startAccount = account.RunJobs
				}
			}
			err := startAccount(ctx, func() { once.Do(func() { ready <- struct{}{} }) })
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
	if recoveryPending && observing {
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
	if run != nil && !run.observing.Load() {
		state, cause, started = "stopped", nil, time.Time{}
	}
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
	observe := run.observing.Load() || telegram.IsHistoryRecovery(ctx)
	c.mu.Lock()
	observer := c.observer
	c.mu.Unlock()
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
		switch update.(type) {
		case *tg.UpdateDeleteMessages, *tg.UpdateDeleteChannelMessages:
			// Source deletes still protect retained rescue files while an
			// account is connected only for manual/history jobs.
			if observer != nil {
				if err := observer(ctx, accountID, update); err != nil {
					return err
				}
			}
			continue
		}
		if !observe {
			continue
		}
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
		work, err := c.work.Claim(run.ctx, run.unthrottled(), time.Now(), !run.observing.Load())
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
		ctx = WithOrigin(ctx, work.Origin)
		progress := &transferStats{started: time.Now()}
		run.mu.Lock()
		run.active[work.ID] = cancel
		run.activeOrigin[work.ID] = work.Origin
		if work.Origin == "live" && !run.observing.Load() {
			cancel()
		}
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
		budget := newAttemptBudget(ctx, c.attemptLimit(work.FileSize))
		attemptCtx := budget.ctx
		if err == nil && (work.ForceRefresh || work.Attempts > 1 || time.Since(time.UnixMilli(work.CreatedAt)) > time.Minute) {
			var fresh *telegram.RefreshedMessage
			if work.Origin == "stories" {
				if source, ok := run.accounts[work.AccountID].(storySource); ok {
					fresh, err = source.RefreshStory(attemptCtx, message)
				} else {
					err = errors.New("account cannot refresh stories")
				}
			} else {
				fresh, err = run.accounts[work.AccountID].RefreshMessage(attemptCtx, message)
			}
			if err == nil && (fresh == nil || fresh.Message == nil) {
				err = errors.New("Telegram refresh returned no message")
			}
			if err == nil && work.Origin == "stories" {
				oldMedia, e := telegram.MessageAttachment(message)
				newMedia, ne := telegram.MessageAttachment(fresh.Message)
				if e != nil || ne != nil || newMedia.GroupID != oldMedia.GroupID || newMedia.MessageID != oldMedia.MessageID {
					err = errors.New("Telegram refresh returned another story")
				}
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
			err = c.sink(attemptCtx, work, message, trackedTransport{MediaDownloader: run.accounts[work.AccountID], stats: progress, total: &c.received, bandwidth: &c.bandwidth, budget: budget})
		}
		if err != nil && attemptCtx.Err() != nil {
			err = context.Cause(attemptCtx)
		}
		budget.stop()
		wasCancelled := ctx.Err() != nil
		cancel()
		run.mu.Lock()
		delete(run.active, work.ID)
		delete(run.activeOrigin, work.ID)
		delete(run.progress, work.ID)
		run.mu.Unlock()
		retry := time.Time{}
		flooded := false
		if d, ok := tgerr.AsFloodWait(err); ok && !wasCancelled {
			// Telegram asked this account to wait: reschedule after the wait
			// without spending one of the item's retry attempts.
			retry, flooded = time.Now().Add(d+time.Second), true
		} else if err != nil && !errors.Is(err, errFiltered) && !wasCancelled && work.Attempts < run.maxAttempts {
			retry = time.Now().Add(time.Second * time.Duration(1<<min(work.Attempts-1, 8)))
		}
		finishCtx, stop := context.WithTimeout(context.Background(), 10*time.Second)
		finishErr := c.work.Finish(finishCtx, work, err, wasCancelled || flooded, retry)
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

// unthrottled lists the run's accounts that Telegram is not currently
// flood-limiting, so workers leave a waiting account's queue alone.
func (r *running) unthrottled() []string {
	ids := make([]string, 0, len(r.ids))
	for _, id := range r.ids {
		if gated, ok := r.accounts[id].(interface{ FloodWaitUntil() time.Time }); ok && !gated.FloodWaitUntil().IsZero() {
			continue
		}
		ids = append(ids, id)
	}
	return ids
}
