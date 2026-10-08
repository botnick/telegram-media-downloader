// Package accounts owns native Telegram account setup and durable publication.
package accounts

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	gotdauth "github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

type PendingAccount struct {
	SessionPath, Label string
	ReservedLabels     []string
	User               *tg.User
}
type WizardConfig struct {
	DataDir string
	Factory telegram.LoginFactory
	Publish func(context.Context, PendingAccount) (string, error)
}
type Wizard struct {
	ctx    context.Context
	cancel context.CancelFunc
	cfg    WizardConfig
	mu     sync.Mutex
	flows  map[string]*flow
	closed bool
}
type BeginResult struct {
	SessionID string `json:"sessionId"`
	State     string `json:"state"`
}
type Status struct {
	State     string  `json:"state"`
	Error     *string `json:"error"`
	Code      *string `json:"code"`
	Seconds   *int    `json:"seconds"`
	Hint      *string `json:"hint"`
	AccountID *string `json:"accountId"`
}
type command struct {
	step, value string
	reply       chan Status
}
type flow struct {
	ctx               context.Context
	cancel            context.CancelFunc
	done              chan struct{}
	commands          chan command
	mu                sync.Mutex
	commitMu          sync.Mutex
	status            Status
	busy              bool
	retryAt, finished time.Time
	cfg               telegram.GotdConfig
	label             string
}

func NewWizard(parent context.Context, cfg WizardConfig) *Wizard {
	ctx, cancel := context.WithCancel(parent)
	if cfg.Factory == nil {
		cfg.Factory = telegram.NewLoginClient
	}
	return &Wizard{ctx: ctx, cancel: cancel, cfg: cfg, flows: map[string]*flow{}}
}

// NormalizeLabel produces one portable filename, never a relative path.
func NormalizeLabel(label string) (string, error) {
	label = strings.ToLower(strings.Join(strings.Fields(label), "_"))
	if len([]rune(label)) > 64 {
		return "", errors.New("Account label is too long")
	}
	for _, r := range label {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) && !unicode.IsMark(r) && r != '_' && r != '-' {
			return "", errors.New("Account label contains invalid characters")
		}
	}
	return label, nil
}
func (w *Wizard) Begin(ctx context.Context, cfg telegram.GotdConfig, label string) (BeginResult, error) {
	if err := ctx.Err(); err != nil {
		return BeginResult{}, err
	}
	label, err := NormalizeLabel(label)
	if err != nil {
		return BeginResult{}, err
	}
	if cfg.AppID <= 0 || cfg.AppHash == "" || cfg.SessionSecret == "" {
		return BeginResult{}, errors.New("Telegram login configuration is incomplete")
	}
	if w.cfg.Publish == nil {
		return BeginResult{}, errors.New("account publication is not configured")
	}
	var random [8]byte
	if _, err = rand.Read(random[:]); err != nil {
		return BeginResult{}, err
	}
	id := hex.EncodeToString(random[:])
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed || w.ctx.Err() != nil {
		return BeginResult{}, errors.New("account wizard is closed")
	}
	w.pruneLocked()
	if len(w.flows) >= 8 {
		return BeginResult{}, errors.New("Too many active authentication sessions")
	}
	for _, f := range w.flows {
		if label != "" && label == f.label {
			return BeginResult{}, fmt.Errorf("Account %q is already being added", label)
		}
	}
	cfg.SessionPath = filepath.Join(w.cfg.DataDir, "sessions", "pending", id+".enc")
	cfg.EncryptedSessionPath = ""
	cfg.UpdateHandler = nil
	flowCtx, cancel := context.WithTimeout(w.ctx, 10*time.Minute)
	f := &flow{ctx: flowCtx, cancel: cancel, done: make(chan struct{}), commands: make(chan command, 1), status: Status{State: "phone"}, cfg: cfg, label: label}
	w.flows[id] = f
	go w.run(f)
	return BeginResult{SessionID: id, State: "phone"}, nil
}
func (w *Wizard) pruneLocked() {
	now := time.Now()
	for id, f := range w.flows {
		f.mu.Lock()
		expired := !f.finished.IsZero() && now.Sub(f.finished) >= time.Minute
		f.mu.Unlock()
		if expired {
			delete(w.flows, id)
		}
	}
}
func (w *Wizard) lookup(id string) *flow {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.pruneLocked()
	return w.flows[id]
}
func (w *Wizard) Status(id string) (Status, bool) {
	f := w.lookup(id)
	if f == nil {
		return Status{}, false
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.status, true
}
func (w *Wizard) Submit(ctx context.Context, id, step, value string) (Status, error) {
	f := w.lookup(id)
	if f == nil {
		return Status{}, errors.New("Auth session not found")
	}
	f.mu.Lock()
	if f.status.State != step {
		state := f.status.State
		f.mu.Unlock()
		return Status{}, fmt.Errorf("Wrong state: %s", state)
	}
	if f.busy {
		f.mu.Unlock()
		return Status{}, errors.New("Authentication request already in progress")
	}
	if step != "password" {
		value = strings.TrimSpace(value)
		if value == "" {
			f.mu.Unlock()
			if step == "phone" {
				return Status{}, errors.New("Phone required")
			}
			return Status{}, errors.New("Code required")
		}
	}
	if time.Now().Before(f.retryAt) {
		status := f.status
		f.mu.Unlock()
		return status, nil
	}
	f.busy = true
	f.status.Error = nil
	f.status.Code = nil
	f.status.Seconds = nil
	f.mu.Unlock()
	cmd := command{step: step, value: value, reply: make(chan Status, 1)}
	select {
	case f.commands <- cmd:
	case <-f.done:
		return Status{}, errors.New("Auth session has ended")
	}
	select {
	case result := <-cmd.reply:
		return result, nil
	case <-ctx.Done():
		return Status{}, ctx.Err()
	case <-f.done:
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.status, nil
	}
}
func (w *Wizard) Cancel(ctx context.Context, id string) (bool, error) {
	f := w.lookup(id)
	if f == nil {
		return false, nil
	}
	// Cancel and publication have one ordering point. Once publication owns
	// this gate it finishes its durable handoff; cancellation cannot undo it.
	f.commitMu.Lock()
	f.cancel()
	f.commitMu.Unlock()
	select {
	case <-f.done:
	case <-ctx.Done():
		return true, ctx.Err()
	}
	w.mu.Lock()
	if w.flows[id] == f {
		delete(w.flows, id)
	}
	w.mu.Unlock()
	return true, nil
}
func (w *Wizard) Close() error {
	w.mu.Lock()
	w.closed = true
	all := make([]*flow, 0, len(w.flows))
	for _, f := range w.flows {
		all = append(all, f)
	}
	w.mu.Unlock()
	w.cancel()
	for _, f := range all {
		<-f.done
	}
	w.mu.Lock()
	clear(w.flows)
	w.mu.Unlock()
	return nil
}
func (f *flow) respond(cmd command) {
	f.mu.Lock()
	f.busy = false
	status := f.status
	f.mu.Unlock()
	cmd.reply <- status
}
func (f *flow) failure(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	message := err.Error()
	f.status.Error = &message
	f.status.Code = nil
	f.status.Seconds = nil
	if d, ok := tgerr.AsFloodWait(err); ok {
		seconds := int(math.Ceil(d.Seconds()))
		code := "FLOOD_WAIT"
		f.status.Code = &code
		f.status.Seconds = &seconds
		f.retryAt = time.Now().Add(d)
		return
	}
	var rpc *tgerr.Error
	if errors.As(err, &rpc) {
		code := rpc.Type
		f.status.Code = &code
	}
	if errors.Is(err, gotdauth.ErrPasswordInvalid) {
		code := "PASSWORD_HASH_INVALID"
		f.status.Code = &code
	}
}
func (f *flow) setState(state string) {
	f.mu.Lock()
	f.status.State = state
	if state != "password" {
		f.status.Hint = nil
	}
	f.mu.Unlock()
}

func (w *Wizard) run(f *flow) {
	handedOff := false
	defer func() {
		f.cancel()
		if !handedOff {
			_ = os.Remove(f.cfg.SessionPath)
		}
		f.mu.Lock()
		f.finished = time.Now()
		f.busy = false
		f.mu.Unlock()
		close(f.done)
	}()
	var cmd command
	select {
	case cmd = <-f.commands:
	case <-f.ctx.Done():
		f.failure(f.ctx.Err())
		f.setState("error")
		return
	}
	client, err := w.cfg.Factory(f.cfg)
	if err != nil {
		f.failure(err)
		f.setState("error")
		f.respond(cmd)
		return
	}
	var user *tg.User
	phone, hash := "", ""
	startup := time.AfterFunc(30*time.Second, f.cancel)
	err = client.Run(f.ctx, func(ctx context.Context, rpc telegram.LoginRPC) error {
		startup.Stop()
		for {
			rpcCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			var authorized *tg.AuthAuthorization
			var callErr error
			switch cmd.step {
			case "phone":
				var sent tg.AuthSentCodeClass
				sent, callErr = rpc.SendCode(rpcCtx, cmd.value, gotdauth.SendCodeOptions{})
				if callErr == nil {
					switch s := sent.(type) {
					case *tg.AuthSentCode:
						phone, hash = cmd.value, s.PhoneCodeHash
						f.setState("code")
					case *tg.AuthSentCodeSuccess:
						authorized, _ = s.Authorization.(*tg.AuthAuthorization)
						if authorized == nil {
							callErr = errors.New("Telegram account registration is required")
						}
					default:
						callErr = fmt.Errorf("unsupported Telegram code delivery %T", sent)
					}
				}
			case "code":
				authorized, callErr = rpc.SignIn(rpcCtx, phone, cmd.value, hash)
			case "password":
				authorized, callErr = rpc.Password(rpcCtx, cmd.value)
			default:
				callErr = errors.New("Unknown authentication step")
			}
			cmd.value = ""
			if errors.Is(callErr, gotdauth.ErrPasswordAuthNeeded) || tgerr.Is(callErr, "SESSION_PASSWORD_NEEDED") {
				hint, hintErr := rpc.PasswordHint(rpcCtx)
				// Telegram has already accepted the code and requires 2FA. Keep
				// the flow at the password prompt even if the optional hint RPC
				// is unavailable; retrying SignIn would be the wrong operation.
				f.setState("password")
				if hintErr != nil {
					callErr = hintErr
				} else {
					f.mu.Lock()
					if hint != "" {
						hint = string([]rune(hint)[:min(len([]rune(hint)), 100)])
						f.status.Hint = &hint
					}
					f.mu.Unlock()
					callErr = nil
				}
			}
			cancel()
			if authorized != nil && callErr == nil {
				user, _ = authorized.User.(*tg.User)
				if user == nil || user.ID <= 0 {
					return errors.New("Telegram authorization returned no user")
				}
				return nil
			}
			if callErr != nil {
				f.failure(callErr)
			}
			f.respond(cmd)
			select {
			case cmd = <-f.commands:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	})
	startup.Stop()
	if err == nil && user == nil {
		// gotd normalizes context.Canceled from Client.Run to nil. A startup
		// timeout or flow expiry must still terminate the wizard visibly.
		if cause := f.ctx.Err(); cause != nil {
			err = cause
		} else {
			err = errors.New("Telegram login ended without authorization")
		}
	}
	if err == nil && user != nil {
		f.commitMu.Lock()
		if err = f.ctx.Err(); err == nil {
			handedOff = true
			var id string
			id, err = w.cfg.Publish(f.ctx, PendingAccount{SessionPath: f.cfg.SessionPath, Label: f.label, ReservedLabels: w.reservedLabels(f), User: user})
			if err == nil {
				f.mu.Lock()
				f.status = Status{State: "done", AccountID: &id}
				f.mu.Unlock()
			}
		}
		f.commitMu.Unlock()
	}
	if err != nil {
		f.failure(err)
		f.setState("error")
	}
	f.mu.Lock()
	busy := f.busy
	f.mu.Unlock()
	if busy {
		f.respond(cmd)
	}
}

func (w *Wizard) reservedLabels(current *flow) []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	reserved := make([]string, 0)
	for _, other := range w.flows {
		if other == current {
			continue
		}
		other.mu.Lock()
		if other.finished.IsZero() && other.label != "" {
			reserved = append(reserved, other.label)
		}
		other.mu.Unlock()
	}
	return reserved
}
