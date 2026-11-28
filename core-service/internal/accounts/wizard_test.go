package accounts

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

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
	// QR sign-in: shown counts tokens put on screen; scan releases the wait
	// with the error it sends (nil = success without a cloud password).
	shown atomic.Int64
	scan  chan error
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
func (f *loginFixture) QR(ctx context.Context, show func(string, time.Time) error) (*tg.AuthAuthorization, error) {
	for i := 0; i < 2; i++ { // the first token expires and is replaced
		if err := show("tg://login?token=fixture"+string(rune('a'+i)), time.Now().Add(30*time.Second)); err != nil {
			return nil, err
		}
		f.shown.Add(1)
	}
	select {
	case err := <-f.scan:
		if err != nil {
			return nil, err
		}
		return &tg.AuthAuthorization{User: &tg.User{ID: 42, FirstName: "Alice"}}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func waitState(t *testing.T, w *Wizard, id, want string) Status {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		status, found := w.Status(id)
		if found && status.State == want {
			return status
		}
		if time.Now().After(deadline) {
			t.Fatalf("state %q never reached: %+v found=%v", want, status, found)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func qrWizard(t *testing.T, f *loginFixture, published *atomic.Int64) (*Wizard, string) {
	t.Helper()
	w := NewWizard(context.Background(), WizardConfig{DataDir: t.TempDir(), Factory: func(telegram.GotdConfig) (telegram.LoginClient, error) { return f, nil }, Publish: func(_ context.Context, p PendingAccount) (string, error) {
		if !f.closed.Load() {
			t.Error("published a key while login client still owned it")
		}
		published.Add(1)
		return "alice", nil
	}})
	t.Cleanup(func() { _ = w.Close() })
	begin, err := w.Begin(context.Background(), telegram.GotdConfig{AppID: 1, AppHash: "fixture", SessionSecret: "fixture"}, "")
	if err != nil {
		t.Fatal(err)
	}
	return w, begin.SessionID
}

func TestWizardQRAnswersOnFirstCodeThenFinishesOnScan(t *testing.T) {
	f := &loginFixture{scan: make(chan error)}
	var published atomic.Int64
	w, id := qrWizard(t, f, &published)
	status, err := w.Submit(context.Background(), id, "qr", "")
	if err != nil || status.State != "qr" || status.QRURL == nil || !strings.HasPrefix(*status.QRURL, "tg://login?token=") {
		t.Fatalf("qr: %+v %v", status, err)
	}
	if status.QRImage == nil || !strings.HasPrefix(*status.QRImage, "data:image/png;base64,") || status.QRExpires == nil {
		t.Fatalf("qr image: %+v", status)
	}
	if _, err = w.Submit(context.Background(), id, "phone", "+10000000001"); err == nil {
		t.Fatal("phone accepted while a QR sign-in runs")
	}
	if _, err = w.Submit(context.Background(), id, "qr", ""); err == nil {
		t.Fatal("second QR start accepted")
	}
	for f.shown.Load() < 2 {
		time.Sleep(time.Millisecond)
	}
	if s := waitState(t, w, id, "qr"); s.QRURL == nil || *s.QRURL != "tg://login?token=fixtureb" {
		t.Fatalf("refreshed token not shown: %+v", s)
	}
	f.scan <- nil
	done := waitState(t, w, id, "done")
	if done.AccountID == nil || *done.AccountID != "alice" || published.Load() != 1 || done.QRImage != nil {
		t.Fatalf("finish: %+v published=%d", done, published.Load())
	}
}

func TestWizardQRWithCloudPasswordAsksForIt(t *testing.T) {
	f := &loginFixture{scan: make(chan error, 1)}
	var published atomic.Int64
	w, id := qrWizard(t, f, &published)
	if _, err := w.Submit(context.Background(), id, "qr", ""); err != nil {
		t.Fatal(err)
	}
	f.scan <- &tgerr.Error{Code: 401, Type: "SESSION_PASSWORD_NEEDED", Message: "SESSION_PASSWORD_NEEDED"}
	status := waitState(t, w, id, "password")
	if status.Hint == nil || *status.Hint != "a hint" || status.QRURL != nil || status.Error != nil {
		t.Fatalf("password prompt: %+v", status)
	}
	status, err := w.Submit(context.Background(), id, "password", " correct password ")
	if err != nil || status.State != "done" || published.Load() != 1 {
		t.Fatalf("finish: %+v %v", status, err)
	}
}

func TestWizardQRFailureAfterShowEndsTheFlow(t *testing.T) {
	f := &loginFixture{scan: make(chan error, 1)}
	var published atomic.Int64
	w, id := qrWizard(t, f, &published)
	if _, err := w.Submit(context.Background(), id, "qr", ""); err != nil {
		t.Fatal(err)
	}
	f.scan <- &tgerr.Error{Code: 400, Type: "AUTH_TOKEN_EXPIRED", Message: "AUTH_TOKEN_EXPIRED"}
	status := waitState(t, w, id, "error")
	if status.Code == nil || *status.Code != "AUTH_TOKEN_EXPIRED" || published.Load() != 0 {
		t.Fatalf("error: %+v", status)
	}
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
