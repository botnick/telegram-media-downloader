package accounts

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/botnick/telegram-media-downloader/core-service/internal/telegram"
	gotdauth "github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

type loginFixture struct {
	calls    atomic.Int64
	closed   atomic.Bool
	password atomic.Int64
	flood    bool
	hintErr  bool
}

func (f *loginFixture) Run(ctx context.Context, fn func(context.Context, telegram.LoginRPC) error) error {
	defer f.closed.Store(true)
	return fn(ctx, f)
}
func (f *loginFixture) SendCode(_ context.Context, phone string, _ gotdauth.SendCodeOptions) (tg.AuthSentCodeClass, error) {
	f.calls.Add(1)
	if phone != "+10000000001" {
		return nil, errors.New("wrong phone argument")
	}
	if f.flood {
		return nil, &tgerr.Error{Code: 420, Type: "FLOOD_WAIT", Argument: 30, Message: "FLOOD_WAIT_30"}
	}
	return &tg.AuthSentCode{PhoneCodeHash: "private-code-hash"}, nil
}
func (f *loginFixture) SignIn(_ context.Context, phone, code, hash string) (*tg.AuthAuthorization, error) {
	if phone != "+10000000001" || hash != "private-code-hash" {
		return nil, errors.New("lost phone/code hash")
	}
	if code != "12345" {
		return nil, &tgerr.Error{Code: 400, Type: "PHONE_CODE_INVALID", Message: "PHONE_CODE_INVALID"}
	}
	return nil, gotdauth.ErrPasswordAuthNeeded
}
func (f *loginFixture) PasswordHint(context.Context) (string, error) {
	if f.hintErr {
		return "", errors.New("hint unavailable")
	}
	return "a hint", nil
}
func (f *loginFixture) Password(_ context.Context, password string) (*tg.AuthAuthorization, error) {
	f.password.Add(1)
	if password != " correct password " {
		return nil, gotdauth.ErrPasswordInvalid
	}
	return &tg.AuthAuthorization{User: &tg.User{ID: 42, FirstName: "Alice", Username: "alice", Phone: "10000000001"}}, nil
}
func TestWizardRetriesPromptAndClosesConnectionBeforePublish(t *testing.T) {
	f := new(loginFixture)
	var published atomic.Int64
	w := NewWizard(context.Background(), WizardConfig{DataDir: t.TempDir(), Factory: func(telegram.GotdConfig) (telegram.LoginClient, error) { return f, nil }, Publish: func(_ context.Context, p PendingAccount) (string, error) {
		if !f.closed.Load() {
			t.Error("published a key while login client still owned it")
		}
		if p.User.ID != 42 || p.Label != "alice_test" {
			t.Errorf("wrong publication: %+v", p)
		}
		published.Add(1)
		return "alice_test", nil
	}})
	defer w.Close()
	begin, err := w.Begin(context.Background(), telegram.GotdConfig{AppID: 1, AppHash: "fixture", SessionSecret: "fixture"}, "Alice Test")
	if err != nil {
		t.Fatal(err)
	}
	if f.calls.Load() != 0 {
		t.Fatal("begin dialed before phone")
	}
	if _, err = w.Submit(context.Background(), begin.SessionID, "code", "12345"); err == nil {
		t.Fatal("wrong-state code accepted")
	}
	status, err := w.Submit(context.Background(), begin.SessionID, "phone", "+10000000001")
	if err != nil || status.State != "code" {
		t.Fatalf("phone: %+v %v", status, err)
	}
	status, err = w.Submit(context.Background(), begin.SessionID, "code", "wrong")
	if err != nil || status.State != "code" || status.Code == nil || *status.Code != "PHONE_CODE_INVALID" {
		t.Fatalf("wrong code: %+v %v", status, err)
	}
	status, err = w.Submit(context.Background(), begin.SessionID, "code", "12345")
	if err != nil || status.State != "password" || status.Hint == nil || *status.Hint != "a hint" {
		t.Fatalf("password prompt: %+v %v", status, err)
	}
	status, err = w.Submit(context.Background(), begin.SessionID, "password", "wrong")
	if err != nil || status.State != "password" {
		t.Fatalf("wrong password: %+v %v", status, err)
	}
	status, err = w.Submit(context.Background(), begin.SessionID, "password", " correct password ")
	if err != nil || status.State != "done" || published.Load() != 1 {
		t.Fatalf("finish: %+v %v", status, err)
	}
}
func TestWizardFloodWaitDoesNotReplayPhoneAndCancelRemovesFlow(t *testing.T) {
	f := &loginFixture{flood: true}
	w := NewWizard(context.Background(), WizardConfig{DataDir: t.TempDir(), Factory: func(telegram.GotdConfig) (telegram.LoginClient, error) { return f, nil }, Publish: func(context.Context, PendingAccount) (string, error) {
		t.Error("published cancelled login")
		return "", nil
	}})
	defer w.Close()
	begin, err := w.Begin(context.Background(), telegram.GotdConfig{AppID: 1, AppHash: "fixture", SessionSecret: "fixture"}, "")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		status, err := w.Submit(context.Background(), begin.SessionID, "phone", "+10000000001")
		if err != nil || status.Seconds == nil || *status.Seconds != 30 {
			t.Fatalf("flood: %+v %v", status, err)
		}
	}
	if f.calls.Load() != 1 {
		t.Fatal("flood wait issued another RPC")
	}
	found, err := w.Cancel(context.Background(), begin.SessionID)
	if err != nil || !found {
		t.Fatal(err)
	}
	if _, found = w.Status(begin.SessionID); found {
		t.Fatal("cancelled flow remains visible")
	}
}

func TestWizardKeepsPasswordPromptWhenHintFails(t *testing.T) {
	f := &loginFixture{hintErr: true}
	w := NewWizard(context.Background(), WizardConfig{DataDir: t.TempDir(), Factory: func(telegram.GotdConfig) (telegram.LoginClient, error) { return f, nil }, Publish: func(context.Context, PendingAccount) (string, error) { return "alice", nil }})
	defer w.Close()
	begin, err := w.Begin(context.Background(), telegram.GotdConfig{AppID: 1, AppHash: "fixture", SessionSecret: "fixture"}, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = w.Submit(context.Background(), begin.SessionID, "phone", "+10000000001"); err != nil {
		t.Fatal(err)
	}
	status, err := w.Submit(context.Background(), begin.SessionID, "code", "12345")
	if err != nil || status.State != "password" || status.Error == nil {
		t.Fatalf("hint failure lost password prompt: %+v %v", status, err)
	}
	status, err = w.Submit(context.Background(), begin.SessionID, "password", " correct password ")
	if err != nil || status.State != "done" || f.password.Load() != 1 {
		t.Fatalf("password was not accepted after hint failure: %+v %v", status, err)
	}
}

type nilOnCancelLogin struct{}

func (nilOnCancelLogin) Run(ctx context.Context, _ func(context.Context, telegram.LoginRPC) error) error {
	<-ctx.Done()
	return nil // gotd's Client.Run has this same cancellation normalization.
}
func (nilOnCancelLogin) SendCode(context.Context, string, gotdauth.SendCodeOptions) (tg.AuthSentCodeClass, error) {
	panic("unreachable")
}
func (nilOnCancelLogin) SignIn(context.Context, string, string, string) (*tg.AuthAuthorization, error) {
	panic("unreachable")
}
func (nilOnCancelLogin) Password(context.Context, string) (*tg.AuthAuthorization, error) {
	panic("unreachable")
}
func (nilOnCancelLogin) PasswordHint(context.Context) (string, error) { panic("unreachable") }

func TestWizardTreatsNilRunAfterCancellationAsTerminalError(t *testing.T) {
	parent, cancelParent := context.WithCancel(context.Background())
	w := NewWizard(parent, WizardConfig{DataDir: t.TempDir(), Factory: func(telegram.GotdConfig) (telegram.LoginClient, error) { return nilOnCancelLogin{}, nil }, Publish: func(context.Context, PendingAccount) (string, error) {
		t.Fatal("published unauthorised login")
		return "", nil
	}})
	defer w.Close()
	begin, err := w.Begin(context.Background(), telegram.GotdConfig{AppID: 1, AppHash: "fixture", SessionSecret: "fixture"}, "")
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, submitErr := w.Submit(context.Background(), begin.SessionID, "phone", "+10000000001")
		result <- submitErr
	}()
	cancelParent()
	<-result
	status, ok := w.Status(begin.SessionID)
	if !ok {
		t.Fatal("cancelled flow was removed before terminal status could be observed")
	}
	if status.State != "error" || status.Error == nil {
		t.Fatalf("nil cancellation remained usable: %+v", status)
	}
}
